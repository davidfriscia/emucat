import { z } from 'zod';
import { versionDeletabilitySchema } from './cleanup.js';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * The version tree, snapshots and Remote Snapshot working copies. See decisions 0037 to 0039. Everything
 * here is for administrators: no version data appears in a public response.
 */

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const errorMessageSchema = z.string().max(1024);

export const VERSION_KINDS = ['master', 'snapshot'] as const;
export const versionKindSchema = z.enum(VERSION_KINDS);
export type VersionKind = z.infer<typeof versionKindSchema>;

/** Which agent's copy derives from a version, and how much is known about it. */
export const versionHolderSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  /** `local`: the persistent copy under the base path. `workspace`: a Remote Snapshot working copy. */
  kind: z.enum(['local', 'workspace']),
  contentStatus: z.enum(['unverified', 'verified', 'modified']).nullable(),
  workspaceId: z.uuid().nullable(),
});
export type VersionHolder = z.infer<typeof versionHolderSchema>;

/**
 * One node. No archive key, repository address, credential or local path: only what an administrator
 * needs to choose a version, and what the agent verified about it.
 */
export const versionNodeSchema = z.object({
  id: z.uuid(),
  kind: versionKindSchema,
  parentVersionId: z.uuid().nullable(),
  childVersionIds: z.array(z.uuid()),
  /** `VM_NAME_YYYYMMDDhhmm` for a snapshot. A label, never unique. */
  snapshotName: z.string().nullable(),
  createdAt: timestampSchema,
  archiveSizeBytes: safeSizeSchema,
  archiveSha256: sha256HexSchema,
  /** What the agent verified when it published the archive, when that is recorded. */
  manifest: z
    .object({
      sha256: sha256HexSchema,
      fileCount: safeSizeSchema,
      totalUncompressedBytes: safeSizeSchema,
      verifiedBy: z.literal('agent'),
    })
    .nullable(),
  repositoryName: z.string(),
  /** Whether the repository holding it is enabled. A disabled one cannot be restored from. */
  available: z.boolean(),
  createdByAgentName: z.string().nullable(),
  createdByDisplayName: z.string().nullable(),
  holders: z.array(versionHolderSchema),
  /**
   * Set while the snapshot is being deleted: it is unavailable for everything from that moment, and leaves
   * the tree once its archive is gone (decision 0041). Deleted versions are never listed.
   */
  deletion: z
    .object({
      requestedAt: timestampSchema,
      attempts: z.number().int().nonnegative(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    })
    .nullable(),
  /** Whether this version could be deleted now. Never for the master. */
  deletable: versionDeletabilitySchema,
});
export type VersionNode = z.infer<typeof versionNodeSchema>;

export const versionTreeResponseSchema = z.object({
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  rootVersionId: z.uuid().nullable(),
  /** Oldest first. Parents always come before their children. */
  versions: z.array(versionNodeSchema),
});
export type VersionTreeResponse = z.infer<typeof versionTreeResponseSchema>;

export interface VersionTreeEntry {
  node: VersionNode;
  depth: number;
  children: VersionTreeEntry[];
}

export type VersionTreeProblem =
  | 'no_root'
  | 'several_roots'
  | 'unknown_parent'
  | 'cycle'
  | 'duplicate_id'
  | 'master_with_parent'
  | 'snapshot_without_parent';

export type VersionTreeResult =
  | { ok: true; root: VersionTreeEntry | null; count: number }
  | { ok: false; problem: VersionTreeProblem; versionId: string | null };

/**
 * Builds the tree from its nodes, refusing anything that is not one: several roots, a parent that is not
 * there, a cycle, or a node whose shape contradicts its kind. Children are ordered by creation time. An
 * empty list is an empty tree. The database already makes these impossible; this makes sure a client
 * reports, rather than draws, a tree that is wrong.
 */
export function buildVersionTree(nodes: readonly VersionNode[]): VersionTreeResult {
  if (nodes.length === 0) return { ok: true, root: null, count: 0 };
  const byId = new Map<string, VersionNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) return { ok: false, problem: 'duplicate_id', versionId: node.id };
    byId.set(node.id, node);
  }
  let root: VersionNode | null = null;
  const children = new Map<string, VersionNode[]>();
  for (const node of nodes) {
    if (node.kind === 'master' && node.parentVersionId !== null) {
      return { ok: false, problem: 'master_with_parent', versionId: node.id };
    }
    if (node.kind === 'snapshot' && node.parentVersionId === null) {
      return { ok: false, problem: 'snapshot_without_parent', versionId: node.id };
    }
    if (node.parentVersionId === null) {
      if (root) return { ok: false, problem: 'several_roots', versionId: node.id };
      root = node;
      continue;
    }
    if (!byId.has(node.parentVersionId)) {
      return { ok: false, problem: 'unknown_parent', versionId: node.id };
    }
    const siblings = children.get(node.parentVersionId) ?? [];
    siblings.push(node);
    children.set(node.parentVersionId, siblings);
  }
  if (!root) return { ok: false, problem: 'no_root', versionId: null };

  let count = 0;
  const visit = (node: VersionNode, depth: number): VersionTreeEntry => {
    count += 1;
    const ordered = [...(children.get(node.id) ?? [])].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    return { node, depth, children: ordered.map((child) => visit(child, depth + 1)) };
  };
  const tree = visit(root, 0);
  // Every node has one parent that exists, so anything not reached from the root is on a cycle.
  if (count !== nodes.length) {
    const reached = new Set<string>();
    const mark = (entry: VersionTreeEntry) => {
      reached.add(entry.node.id);
      entry.children.forEach(mark);
    };
    mark(tree);
    const stray = nodes.find((node) => !reached.has(node.id));
    return { ok: false, problem: 'cycle', versionId: stray?.id ?? null };
  }
  return { ok: true, root: tree, count };
}

/** The path from the root to a version, root first, or `null` if it is not in the tree. */
export function versionLineage(nodes: readonly VersionNode[], versionId: string): string[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let current = byId.get(versionId);
  while (current) {
    if (path.includes(current.id)) return null;
    path.unshift(current.id);
    if (current.parentVersionId === null) return path;
    current = byId.get(current.parentVersionId);
  }
  return null;
}

// Creating a snapshot.

/**
 * Snapshots the agent's persistent copy of a registered VM. The parent must be the version that copy came
 * from, which the server and the agent both check. Nothing names a path, a repository or an archive key.
 */
export const createSnapshotRequestSchema = z.strictObject({
  agentId: z.uuid(),
  parentVersionId: z.uuid(),
  /** Chosen by the browser, so that a repeated click or a retried request creates one snapshot. */
  requestId: z.uuid(),
});
export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

export const SNAPSHOT_INELIGIBLE_REASONS = [
  'agent_revoked',
  'agent_offline',
  'agent_cannot_snapshot',
  'local_copy_missing',
  'local_copy_unsafe',
  'snapshot_parent_unknown',
  'snapshot_parent_mismatch',
  'snapshot_lineage_unverified',
  'repository_not_authorized',
  'repository_disabled',
  'vm_running',
  'operation_in_progress',
] as const;
export type SnapshotIneligibleReason = (typeof SNAPSHOT_INELIGIBLE_REASONS)[number];

export const SNAPSHOT_INELIGIBLE_TEXT: Record<SnapshotIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_snapshot: 'This agent’s version cannot create snapshots. Update it.',
  local_copy_missing: 'This agent holds no local copy of this VM.',
  local_copy_unsafe:
    'The last operation on this agent’s copy left it in an error state. Check that computer first.',
  snapshot_parent_unknown:
    'Which version this local copy came from is not known, so a snapshot could not say what it branches from.',
  snapshot_parent_mismatch:
    'This agent’s local copy comes from another version. Choose that version as the parent.',
  snapshot_lineage_unverified:
    'This copy disappeared and came back since it was last verified, so nothing proves which version it came from. Verify it first.',
  repository_not_authorized: 'This agent is not associated with this VM’s repository.',
  repository_disabled: 'The repository of this VM is disabled.',
  vm_running:
    'This VM is running on this agent, or may be. Stop it, or dismiss the session, before creating a snapshot.',
  operation_in_progress: 'This agent, or this VM, is busy with another operation.',
};

// Working copies, and the remote sessions that run them (decisions 0038 and 0040).

/**
 * What a working copy is for. `manual` is a Milestone 7 working copy, prepared, preserved and discarded by
 * hand, and never advanced automatically. The others are remote sessions: a temporary copy of a chosen
 * version that the server prepares, launches, publishes (Remote Snapshot) and removes on its own.
 */
export const WORKSPACE_PURPOSES = ['manual', 'remote_volatile', 'remote_snapshot'] as const;
export const workspacePurposeSchema = z.enum(WORKSPACE_PURPOSES);
export type WorkspacePurpose = z.infer<typeof workspacePurposeSchema>;

export const REMOTE_SESSION_MODES = ['remote_volatile', 'remote_snapshot'] as const;
export const remoteSessionModeSchema = z.enum(REMOTE_SESSION_MODES);
export type RemoteSessionMode = z.infer<typeof remoteSessionModeSchema>;

export const WORKSPACE_STATES = [
  'preparing',
  'ready',
  'running',
  'held',
  'publishing',
  'publish_failed',
  'discarding',
  'discarded',
  'failed',
  'lost',
] as const;
export const workspaceStateSchema = z.enum(WORKSPACE_STATES);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const WORKSPACE_ACTIVE_STATES: readonly WorkspaceState[] = [
  'preparing',
  'ready',
  'running',
  'held',
  'publishing',
  'publish_failed',
  'discarding',
];

export function isWorkspaceActive(state: WorkspaceState): boolean {
  return WORKSPACE_ACTIVE_STATES.includes(state);
}

export const vmWorkspaceSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  purpose: workspacePurposeSchema,
  state: workspaceStateSchema,
  /** The version chosen at launch, and restored into it. A Remote Snapshot's parent is exactly this one. */
  baseVersionId: z.uuid(),
  /** What it is a copy of now: a preservation moves this to the new snapshot. */
  sourceVersionId: z.uuid(),
  /** A session was created since the last preservation, so it may differ from its source. */
  mayHaveChanges: z.boolean(),
  launchOnReady: z.boolean(),
  restoreOperationId: z.uuid().nullable(),
  /** The session that ran it. Remote sessions only. */
  sessionId: z.uuid().nullable(),
  /** The current publication attempt of a Remote Snapshot, and how many there have been. */
  snapshotOperationId: z.uuid().nullable(),
  publishAttempts: z.number().int().nonnegative(),
  /** When the server will retry an automatic step by itself, if it will. */
  nextRetryAt: timestampSchema.nullable(),
  /** An administrator gave up the uncommitted snapshot. */
  abandonedAt: timestampSchema.nullable(),
  /** The version a committed Remote Snapshot created. */
  snapshotVersionId: z.uuid().nullable(),
  localDirectory: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export type VmWorkspace = z.infer<typeof vmWorkspaceSchema>;

export const workspaceListResponseSchema = z.object({ workspaces: z.array(vmWorkspaceSchema) });
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

/**
 * Starts a remote session: a temporary copy of exactly this version on this agent, launched as soon as it
 * is ready, then removed (Remote Volatile) or published as a child snapshot of this version and removed
 * (Remote Snapshot). A repeated request ID finds the same session.
 */
export const createWorkspaceRequestSchema = z.strictObject({
  agentId: z.uuid(),
  versionId: z.uuid(),
  requestId: z.uuid(),
  mode: remoteSessionModeSchema,
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

/** Retries a failed Remote Snapshot publication. Nothing is published twice. */
export const retryPublicationRequestSchema = z.strictObject({});
export type RetryPublicationRequest = z.infer<typeof retryPublicationRequestSchema>;

/**
 * Lets a held remote session go on: the administrator has checked that its emulator no longer runs. The
 * VM's name is typed again, because what follows publishes or removes its files.
 */
export const resumeWorkspaceRequestSchema = z.strictObject({
  confirmVmName: z.string().min(1).max(255),
});
export type ResumeWorkspaceRequest = z.infer<typeof resumeWorkspaceRequestSchema>;

/** Why a remote session is still active, for the interface. */
export function isWorkspaceAutomatic(purpose: WorkspacePurpose): boolean {
  return purpose !== 'manual';
}

export const launchWorkspaceRequestSchema = z.strictObject({ requestId: z.uuid() });
export type LaunchWorkspaceRequest = z.infer<typeof launchWorkspaceRequestSchema>;

/** Preserves a stopped working copy as a new snapshot of its source version. */
export const preserveWorkspaceRequestSchema = z.strictObject({ requestId: z.uuid() });
export type PreserveWorkspaceRequest = z.infer<typeof preserveWorkspaceRequestSchema>;

/** Unpreserved changes are lost, so the VM's name has to be typed when there may be some. */
export const discardWorkspaceRequestSchema = z.strictObject({
  confirmVmName: z.string().max(255).optional(),
});
export type DiscardWorkspaceRequest = z.infer<typeof discardWorkspaceRequestSchema>;

export const workspacePathParamsSchema = z.strictObject({ workspaceId: z.uuid() });

// The protocol.

export const workspaceDiscardPayloadSchema = z.strictObject({
  workspaceId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
});
export type WorkspaceDiscardPayload = z.infer<typeof workspaceDiscardPayloadSchema>;

export const workspaceDiscardResultPayloadSchema = z.object({
  workspaceId: z.uuid(),
  removed: z.boolean(),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type WorkspaceDiscardResultPayload = z.infer<typeof workspaceDiscardResultPayloadSchema>;
