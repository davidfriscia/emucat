import type {
  AdminVmDetail,
  RestoreOptionsResponse,
  VersionNode,
  VersionTreeResponse,
} from '@emucat/contracts';

/**
 * The version histories the Version History browser tests draw: synthetic, deterministic, and shaped as the API
 * answers. `single` is a master alone, `one` a master with one snapshot, `branches` a master with two branches, one of
 * them three levels deep, a stale local copy, a snapshot that cannot be deleted now and long names.
 */

export type Scenario = 'single' | 'one' | 'branches';

export const VM = { emulatorType: '86box', vmName: 'DOS622' } as const;
export const VM_PATH = `/admin/vms/${VM.emulatorType}/${VM.vmName}`;
export const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9001';
export const AGENT_NAME = 'LOQ Test Agent';
export const MASTER = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9010';
export const SNAP_A = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9011';
export const SNAP_B = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9012';
export const SNAP_C = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9013';
export const SNAP_D = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9014';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9030';
const SHA = 'c'.repeat(64);
const PAST = '2026-11-01T00:00:00.000Z';

function version(
  id: string,
  parent: string | null,
  createdAt: string,
  snapshotName: string | null,
  overrides: Partial<VersionNode> = {},
): VersionNode {
  return {
    id,
    kind: parent === null ? 'master' : 'snapshot',
    parentVersionId: parent,
    childVersionIds: [],
    snapshotName,
    title: null,
    description: null,
    tags: [],
    createdAt,
    promotedAt: null,
    archiveSizeBytes: 270_637_465,
    archiveSha256: SHA,
    manifest: {
      sha256: SHA,
      fileCount: 7,
      totalUncompressedBytes: 709_885_952,
      verifiedBy: 'agent',
    },
    repositoryName: 'My Storage',
    available: true,
    createdByAgentName: AGENT_NAME,
    createdByDisplayName: 'Ada Admin',
    holders: [],
    deletion: null,
    deletable:
      parent === null
        ? { eligible: false, reason: 'master_cannot_be_deleted' }
        : { eligible: true, reason: null },
    ...overrides,
  };
}

const master = (): VersionNode =>
  version(MASTER, null, '2026-11-08T21:56:00.000Z', null, {
    tags: [{ id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9040', name: 'gold' }],
    holders: [
      {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        kind: 'local',
        contentStatus: 'unverified',
        workspaceId: null,
      },
    ],
  });

export function tree(scenario: Scenario): VersionTreeResponse {
  const versions: VersionNode[] = [master()];
  if (scenario !== 'single') {
    versions.push(
      version(SNAP_A, MASTER, '2026-11-18T21:36:00.000Z', 'DOS622_202611182136', {
        deletable: { eligible: false, reason: 'repository_unavailable' },
      }),
    );
  }
  if (scenario === 'branches') {
    versions.push(
      version(SNAP_B, MASTER, '2026-11-20T10:15:00.000Z', 'DOS622_202611201015', {
        title: 'Sound Blaster 16 and CD-ROM drivers installed',
        description: 'AUTOEXEC.BAT and CONFIG.SYS set up for SB16.\nMSCDEX loads from C:\\DOS.',
        tags: [{ id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9041', name: 'drivers' }],
        deletable: { eligible: false, reason: 'snapshot_has_descendants' },
      }),
      version(SNAP_C, SNAP_B, '2026-11-22T17:40:00.000Z', 'DOS622_202611221740', {
        deletable: { eligible: false, reason: 'snapshot_has_descendants' },
        manifest: null,
      }),
      version(SNAP_D, SNAP_C, '2026-11-24T09:05:00.000Z', 'DOS622_202611240905', {
        title:
          'Windows 3.11 for Workgroups with Video for Windows, Sound Recorder and a very long title that wraps',
        archiveSizeBytes: 312_420_118,
      }),
    );
  }
  for (const item of versions) {
    item.childVersionIds = versions
      .filter((child) => child.parentVersionId === item.id)
      .map((c) => c.id);
  }
  return { emulatorType: VM.emulatorType, vmName: VM.vmName, rootVersionId: MASTER, versions };
}

/** What remastering from the local copy would do: replace every version, the master included. */
export function remasterPreview(scenario: Scenario) {
  const versions = tree(scenario).versions.map((item) => ({
    id: item.id,
    kind: item.kind,
    parentVersionId: item.parentVersionId,
    snapshotName: item.snapshotName,
    title: item.title,
    createdAt: item.createdAt,
    archiveSizeBytes: item.archiveSizeBytes,
  }));
  return {
    kind: 'local_copy',
    emulatorType: VM.emulatorType,
    vmName: VM.vmName,
    revision: 'd'.repeat(64),
    currentMaster: versions[0],
    promoted: null,
    retained: [],
    removed: versions,
    removedBytes: versions.reduce((total, item) => total + item.archiveSizeBytes, 0),
    source: {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      online: true,
      sourceName: VM.vmName,
      machineUuid: null,
      localSourceVersionId: MASTER,
      contentStatus: 'unverified',
    },
    lineageConflicts: [],
    cleanupAvailable: true,
    refusal: null,
  };
}

export function restoreOptions(scenario: Scenario): RestoreOptionsResponse {
  const versions = tree(scenario).versions.map((item) => ({
    versionId: item.id,
    repositoryId: REPOSITORY_ID,
    repositoryName: item.repositoryName,
    repositoryEnabled: true,
    archiveSizeBytes: item.archiveSizeBytes,
    archiveSha256: item.archiveSha256,
    createdAt: item.createdAt,
    manifestSha256: item.manifest?.sha256 ?? null,
    fileCount: item.manifest?.fileCount ?? null,
    totalUncompressedBytes: item.manifest?.totalUncompressedBytes ?? null,
    kind: item.kind,
    parentVersionId: item.parentVersionId,
    snapshotName: item.snapshotName,
  }));
  return {
    master: versions[0] ?? null,
    versions,
    agents: [
      {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        online: true,
        eligible: false,
        ineligibleReason: 'local_copy_exists',
        destination: 'C:\\EmuCat\\86box\\DOS622',
        local: {
          availability: 'present',
          contentStatus: 'unverified',
          sourceVersionId: MASTER,
          lastVerifiedAt: null,
        },
        replace: { eligible: true, reason: null },
        running: false,
        remove: { eligible: true, reason: null },
        cacheUsedBytes: null,
        cacheMaxBytes: null,
      },
    ],
  };
}

export function adminVm(scenario: Scenario): AdminVmDetail {
  return {
    emulatorType: VM.emulatorType,
    vmName: VM.vmName,
    displayName: 'MS-DOS 6.22',
    description: 'MS-DOS 6.22 on a 486',
    visibility: 'private',
    mainMediaId: null,
    publicCover: 'vm_private',
    mediaCount: 0,
    versionCount: tree(scenario).versions.length,
    tags: [],
    clonedFrom: null,
    createdAt: PAST,
    updatedAt: PAST,
  } as AdminVmDetail;
}

export const SESSION = {
  session: {
    user: {
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
      username: 'admin',
      displayName: 'Ada Admin',
      role: 'admin',
    },
    csrfToken: 'harness-csrf-token',
    sessionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61',
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
};
