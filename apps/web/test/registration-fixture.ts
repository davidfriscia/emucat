import type { RegistrationOperation } from '@emucat/contracts';

/** A transfer whose master exists, and whose removal a screenshot blocked. */
export function registrationOperation(): RegistrationOperation {
  return {
    id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6100',
    agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6103',
    agentName: 'Desk PC',
    agentOnline: true,
    repositoryId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6102',
    repositoryName: 'NAS',
    emulatorType: 'qemu',
    vmName: 'Win98',
    mode: 'transfer',
    state: 'partial_success',
    versionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6101',
    parentVersionId: null,
    snapshotName: null,
    workspaceId: null,
    archiveKey: 'archives/qemu/win98/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6101.zip',
    progress: { doneBytes: null, totalBytes: null },
    archive: {
      sizeBytes: 1000,
      sha256: 'a'.repeat(64),
      manifestVersion: 1,
      manifestSha256: 'b'.repeat(64),
      fileCount: 2,
      totalUncompressedBytes: 2000,
      verifiedBy: 'agent',
    },
    localCopy: 'cleanup_failed',
    error: { code: 'transfer_blocked_media', message: 'capture.ppm has not reached the server' },
    recovery: 'Check the VM’s Media page, and choose Retry removal once it is synchronized.',
    cancelRequested: false,
    requestedByDisplayName: 'Ada Admin',
    createdAt: '2026-01-31T15:30:00.000Z',
    updatedAt: '2026-01-31T15:31:00.000Z',
    committedAt: '2026-01-31T15:31:00.000Z',
    finishedAt: '2026-01-31T15:32:00.000Z',
  };
}
