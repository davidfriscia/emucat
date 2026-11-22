import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema, vmVersionKindSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Cloning a VM from one of its versions (decision 0052). A clone is a new, independent catalog VM: its own
 * identity, its own master, its own archive under its own key, and none of the source's history, screenshots, tags,
 * notes, publication or agent state. What it keeps of the source is a provenance record, which is information only.
 */

/** What an administrator asks for. Nothing here can name a path, a repository or an archive. */
export const cloneVmRequestSchema = z.strictObject({
  /** The agent that downloads the source archive and publishes the clone's. */
  agentId: z.uuid(),
  /** The new VM's name, under the same emulator. The VM name rules apply, and it must be free, ignoring case. */
  vmName: vmNameSchema,
  /** Chosen by the browser, so that a repeated request finds the clone it already started. */
  requestId: z.uuid(),
});
export type CloneVmRequest = z.infer<typeof cloneVmRequestSchema>;

/** Why an agent cannot clone this version now. */
export const CLONE_AGENT_REFUSALS = [
  'agent_offline',
  'agent_revoked',
  'agent_cannot_clone',
  'repository_not_authorized',
  'agent_busy',
] as const;
export type CloneAgentRefusal = (typeof CLONE_AGENT_REFUSALS)[number];

/** Why the version cannot be cloned at all now. */
export const CLONE_VERSION_REFUSALS = [
  'version_deleted',
  'repository_disabled',
  'remaster_in_progress',
] as const;
export type CloneVersionRefusal = (typeof CLONE_VERSION_REFUSALS)[number];

export const CLONE_REFUSAL_TEXT: Record<CloneAgentRefusal | CloneVersionRefusal, string> = {
  agent_offline: 'The agent is offline.',
  agent_revoked: 'The agent has been revoked.',
  agent_cannot_clone: 'The agent is too old to clone VMs. Update it to this release.',
  repository_not_authorized:
    'The agent is not associated with the repository that holds this version.',
  agent_busy: 'The agent is running another operation. Wait for it to finish.',
  version_deleted: 'This version is deleted or being deleted, so it cannot be cloned.',
  repository_disabled: 'The repository that holds this version is disabled.',
  remaster_in_progress: 'A remaster of this VM is running. Wait for it to finish.',
};

export const cloneAgentOptionSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  online: z.boolean(),
  eligible: z.boolean(),
  reason: z.enum(CLONE_AGENT_REFUSALS).nullable(),
});
export type CloneAgentOption = z.infer<typeof cloneAgentOptionSchema>;

/** What the clone dialog needs: the source, whether it can be cloned, and who can do it. */
export const cloneOptionsResponseSchema = z.object({
  source: z.object({
    emulatorType: emulatorTypeSchema,
    vmName: z.string(),
    versionId: z.uuid(),
    kind: vmVersionKindSchema,
    snapshotName: z.string().nullable(),
    title: z.string().nullable(),
    archiveSizeBytes: z.number().int().nonnegative(),
  }),
  /** `null` when the version can be cloned. */
  refusal: z.enum(CLONE_VERSION_REFUSALS).nullable(),
  agents: z.array(cloneAgentOptionSchema),
});
export type CloneOptionsResponse = z.infer<typeof cloneOptionsResponseSchema>;

/**
 * Where a cloned VM came from. Text and identifiers copied when it was cloned: it never depends on the source still
 * existing. `sourceExists` says whether the source VM is still in the catalog now, so a page can link to it, and show
 * the name as plain text otherwise.
 */
export const vmCloneProvenanceSchema = z.object({
  sourceEmulatorType: emulatorTypeSchema,
  sourceVmName: z.string(),
  sourceDisplayName: z.string().nullable(),
  sourceVersionId: z.uuid(),
  sourceVersionKind: vmVersionKindSchema,
  sourceSnapshotName: z.string().nullable(),
  sourceVersionTitle: z.string().nullable(),
  clonedAt: timestampSchema,
  clonedByDisplayName: z.string().nullable(),
  sourceExists: z.boolean(),
});
export type VmCloneProvenance = z.infer<typeof vmCloneProvenanceSchema>;

/** A human label for the version a clone came from. */
export function cloneSourceVersionLabel(
  provenance: Pick<
    VmCloneProvenance,
    'sourceVersionKind' | 'sourceSnapshotName' | 'sourceVersionTitle'
  >,
): string {
  const kind = provenance.sourceVersionKind === 'master' ? 'Master' : 'Snapshot';
  const name = provenance.sourceVersionTitle ?? provenance.sourceSnapshotName;
  return name ? `${kind} — ${name}` : kind;
}

// The protocol.

const archiveKeySchema = z.string().min(1).max(512);
const sizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * `server.clone_request`: download one version's archive, write it again for the new VM, and publish that at the
 * new VM's key. Answered with the usual registration progress, error and cleanup messages, and with
 * `agent.registration_result` (a ZIP, with its new manifest) or `agent.virtualbox_registration_result` (an OVA,
 * copied byte for byte). The agent derives both keys itself and refuses a request whose keys differ. It holds no
 * path and no address.
 */
export const cloneRequestPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  repositoryId: z.uuid(),
  source: z.strictObject({
    vmName: vmNameSchema,
    versionId: z.uuid(),
    archiveKey: archiveKeySchema,
    archiveSizeBytes: sizeSchema,
    archiveSha256: sha256HexSchema,
    /** What the source's registration verified, when known. A ZIP whose manifest differs is refused. */
    manifestSha256: sha256HexSchema.nullable(),
  }),
  target: z.strictObject({
    vmName: vmNameSchema,
    versionId: z.uuid(),
    archiveKey: archiveKeySchema,
  }),
});
export type CloneRequestPayload = z.infer<typeof cloneRequestPayloadSchema>;
