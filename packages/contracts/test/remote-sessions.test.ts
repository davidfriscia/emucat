import { describe, expect, it } from 'vitest';
import {
  RESTORE_ERROR_CODES,
  WORKSPACE_ACTIVE_STATES,
  createRestoreRequestSchema,
  createWorkspaceRequestSchema,
  isWorkspaceActive,
  remoteSessionRecovery,
  remoteSessionStep,
  restoreRecovery,
  restoreRequestPayloadSchema,
  resumeWorkspaceRequestSchema,
} from '../src/index.js';

const ids = {
  agent: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7000',
  version: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001',
  request: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7002',
};

describe('remote sessions', () => {
  it('start with a version and a remote mode, and nothing that says where anything goes', () => {
    const request = { agentId: ids.agent, versionId: ids.version, requestId: ids.request };
    for (const mode of ['remote_volatile', 'remote_snapshot']) {
      expect(createWorkspaceRequestSchema.safeParse({ ...request, mode }).success).toBe(true);
    }
    // Local is not a remote session, and the Milestone 7 "prepare without launching" is gone.
    expect(createWorkspaceRequestSchema.safeParse({ ...request, mode: 'local' }).success).toBe(
      false,
    );
    expect(createWorkspaceRequestSchema.safeParse({ ...request, launch: true }).success).toBe(
      false,
    );
    expect(
      createWorkspaceRequestSchema.safeParse({
        ...request,
        mode: 'remote_volatile',
        directory: 'C:\\Windows',
      }).success,
    ).toBe(false);
    expect(createWorkspaceRequestSchema.safeParse({ ...request }).success).toBe(false);
  });

  it('go through preparation, the run, publication and cleanup, in that order', () => {
    expect(remoteSessionStep('remote_volatile', 'preparing')).toBe('prepare');
    expect(remoteSessionStep('remote_volatile', 'running')).toBe('run');
    expect(remoteSessionStep('remote_volatile', 'held')).toBe('run');
    expect(remoteSessionStep('remote_volatile', 'discarding')).toBe('cleanup');
    expect(remoteSessionStep('remote_snapshot', 'publishing')).toBe('publish');
    expect(remoteSessionStep('remote_snapshot', 'publish_failed')).toBe('publish');
    expect(remoteSessionStep('remote_snapshot', 'discarded')).toBe('done');
    expect(remoteSessionStep('remote_snapshot', 'failed')).toBe('done');
  });

  it('stay active, and so block another remote session, until cleaned up', () => {
    for (const state of [
      'running',
      'held',
      'publishing',
      'publish_failed',
      'discarding',
    ] as const) {
      expect(isWorkspaceActive(state), state).toBe(true);
    }
    for (const state of ['discarded', 'failed', 'lost'] as const) {
      expect(isWorkspaceActive(state), state).toBe(false);
    }
    expect(WORKSPACE_ACTIVE_STATES).toHaveLength(7);
    expect(remoteSessionRecovery('publish_failed')).toMatch(/kept/);
    expect(remoteSessionRecovery('held')).toMatch(/resume/);
  });

  it('are resumed only with the VM name typed again', () => {
    expect(resumeWorkspaceRequestSchema.safeParse({ confirmVmName: 'Win98' }).success).toBe(true);
    expect(resumeWorkspaceRequestSchema.safeParse({ confirmVmName: '' }).success).toBe(false);
    expect(resumeWorkspaceRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('replacing a persistent copy', () => {
  const restore = {
    agentId: ids.agent,
    emulatorType: 'qemu',
    vmName: 'Win98',
    versionId: ids.version,
  };

  it('is explicit, names what the page showed, and acknowledges discarded changes', () => {
    expect(createRestoreRequestSchema.safeParse(restore).success).toBe(true);
    const replace = { expectedVersionId: null, discardLocalChanges: false };
    expect(createRestoreRequestSchema.safeParse({ ...restore, replace }).success).toBe(true);
    expect(
      createRestoreRequestSchema.safeParse({
        ...restore,
        replace: { ...replace, discardLocalChanges: true },
      }).success,
    ).toBe(true);
    // The typed VM name is no longer part of a replacement, and nothing unknown is accepted.
    expect(
      createRestoreRequestSchema.safeParse({
        ...restore,
        replace: { ...replace, confirmVmName: 'Win98' },
      }).success,
    ).toBe(false);
    expect(
      createRestoreRequestSchema.safeParse({
        ...restore,
        replace: { expectedVersionId: null },
      }).success,
    ).toBe(false);
    expect(
      createRestoreRequestSchema.safeParse({
        ...restore,
        replace: { ...replace, destination: 'C:\\Windows' },
      }).success,
    ).toBe(false);
  });

  it('tells the agent what to expect, and nothing about where', () => {
    const payload = {
      operationId: ids.request,
      emulatorType: 'qemu',
      vmName: 'Win98',
      repositoryId: ids.agent,
      versionId: ids.version,
      archiveKey: `archives/qemu/win98/${ids.version}.zip`,
      archiveSizeBytes: 10,
      archiveSha256: 'a'.repeat(64),
      manifestSha256: null,
      expectedUncompressedBytes: null,
    };
    const replace = { expectedVersionId: ids.version, discardLocalChanges: true };
    expect(restoreRequestPayloadSchema.safeParse({ ...payload, replace }).success).toBe(true);
    expect(
      restoreRequestPayloadSchema.safeParse({ ...payload, replace: { ...replace, path: 'C:\\' } })
        .success,
    ).toBe(false);
    expect(
      restoreRequestPayloadSchema.safeParse({ ...payload, workspacePurpose: 'local' }).success,
    ).toBe(false);
  });

  it('explains every refusal it can end with', () => {
    for (const code of [
      'local_copy_modified',
      'local_copy_unverified',
      'local_copy_changed',
      'local_copy_missing',
      'restore_replacement_failed',
    ]) {
      expect(RESTORE_ERROR_CODES).toContain(code);
      expect(restoreRecovery(code), code).toMatch(/kept|Nothing|put back|no local copy|no longer/i);
    }
  });
});
