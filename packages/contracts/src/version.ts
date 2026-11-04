import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { parseSnapshotName } from './snapshot-name.js';
import { vmNameKey, vmNameSchema, type VmIdentity } from './vm-name.js';

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected lowercase SHA-256 hex');
export const timestampSchema = z.iso.datetime({ offset: true });

/** Internal, collision-safe version identifier. Never derived from the snapshot name. */
export const vmVersionIdSchema = z.uuid();
export type VmVersionId = z.infer<typeof vmVersionIdSchema>;

export function newVmVersionId(): VmVersionId {
  return globalThis.crypto.randomUUID();
}

export const VM_VERSION_KINDS = ['master', 'snapshot'] as const;
export const vmVersionKindSchema = z.enum(VM_VERSION_KINDS);
export type VmVersionKind = z.infer<typeof vmVersionKindSchema>;

const versionBase = {
  id: vmVersionIdSchema,
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  archiveSha256: sha256HexSchema,
  archiveSizeBytes: z.number().int().nonnegative(),
  repositoryId: z.uuid(),
  archiveKey: z.string().min(1),
  createdAt: timestampSchema,
};

/**
 * Every version is a full, standalone archive. The parent records where a snapshot came from; it
 * is not needed to restore the snapshot. Several snapshots can share a parent, forming branches.
 */
export const vmVersionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      ...versionBase,
      kind: z.literal('master'),
      parentVersionId: z.null(),
      snapshotName: z.null(),
    }),
    z.object({
      ...versionBase,
      kind: z.literal('snapshot'),
      parentVersionId: vmVersionIdSchema,
      snapshotName: z.string(),
    }),
  ])
  .superRefine((version, context) => {
    if (version.kind !== 'snapshot') return;
    if (version.parentVersionId === version.id) {
      context.addIssue({ code: 'custom', message: 'A snapshot cannot be its own parent' });
    }
    const parsed = parseSnapshotName(version.snapshotName);
    if (!parsed || vmNameKey(parsed.vmName) !== vmNameKey(version.vmName)) {
      context.addIssue({ code: 'custom', message: 'Snapshot name does not match the VM' });
    }
  });
export type VmVersion = z.infer<typeof vmVersionSchema>;

export const VERSION_LINEAGE_ERROR_CODES = [
  'missing_master',
  'multiple_masters',
  'mixed_vms',
  'unknown_parent',
  'duplicate_id',
  'unreachable_from_master',
] as const;
export type VersionLineageErrorCode = (typeof VERSION_LINEAGE_ERROR_CODES)[number];

/**
 * Checks the version tree of a single VM: one master, no foreign or dangling parents, and every
 * snapshot descends from the master (which also rules out cycles). Returns all problems found.
 */
export function validateVersionLineage(
  versions: readonly Pick<
    VmVersion,
    'id' | 'emulatorType' | 'vmName' | 'kind' | 'parentVersionId'
  >[],
): VersionLineageErrorCode[] {
  const errors = new Set<VersionLineageErrorCode>();
  const ids = new Set(versions.map((version) => version.id));
  if (ids.size !== versions.length) errors.add('duplicate_id');

  const masters = versions.filter((version) => version.kind === 'master');
  if (masters.length === 0) errors.add('missing_master');
  if (masters.length > 1) errors.add('multiple_masters');

  const owners = new Set(
    versions.map((version) => `${version.emulatorType}/${vmNameKey(version.vmName)}`),
  );
  if (owners.size > 1) errors.add('mixed_vms');

  const childrenByParent = new Map<string, string[]>();
  for (const version of versions) {
    if (version.parentVersionId === null) continue;
    if (!ids.has(version.parentVersionId)) errors.add('unknown_parent');
    const siblings = childrenByParent.get(version.parentVersionId) ?? [];
    siblings.push(version.id);
    childrenByParent.set(version.parentVersionId, siblings);
  }

  const reachable = new Set<string>();
  const pending = masters.map((master) => master.id);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  if (masters.length > 0 && reachable.size !== ids.size) errors.add('unreachable_from_master');

  return [...errors];
}

/**
 * Object key of a version archive in a remote repository. It is based on the version ID, so two
 * snapshots with the same human-readable name can never overwrite each other.
 */
export function archiveObjectKey(identity: VmIdentity, versionId: VmVersionId): string {
  return `archives/${identity.emulatorType}/${vmNameKey(identity.vmName)}/${versionId}.zip`;
}
