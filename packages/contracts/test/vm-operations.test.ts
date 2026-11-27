import { describe, expect, it } from 'vitest';
import {
  REGISTRATION_STATES,
  isVmOperationActive,
  registrationOperationSchema,
  vmOperationKind,
  vmOperationListResponseSchema,
  vmOperationPercent,
  vmOperationPhase,
  vmOperationSourceVersionId,
  type RegistrationOperation,
} from '../src/index.js';

const PARENT = '5b0c9f7a-1f7e-4d55-9f43-0c1d5a1e2b3c';
const SOURCE = '0f2b7c0e-7c3a-4d0a-8c71-5a8f0b6d1e22';

function operation(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  return registrationOperationSchema.parse({
    id: '9d1b2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    agentId: '1a8acacf-46fc-4468-8a69-3af6c1ea7db0',
    agentName: 'Workstation',
    agentOnline: true,
    performedBy: 'agent',
    repositoryId: '2b8acacf-46fc-4468-8a69-3af6c1ea7db0',
    repositoryName: 'NAS',
    emulatorType: 'qemu',
    vmName: 'Win98',
    mode: 'snapshot',
    state: 'uploading',
    versionId: '3c8acacf-46fc-4468-8a69-3af6c1ea7db0',
    parentVersionId: PARENT,
    snapshotName: 'Win98_202611271200',
    workspaceId: null,
    archiveKey: 'archives/qemu/win98/x.zip',
    progress: { doneBytes: 50, totalBytes: 200 },
    archive: null,
    localCopy: null,
    error: null,
    recovery: null,
    cancelRequested: false,
    requestedByDisplayName: 'David',
    createdAt: '2026-11-27T12:00:00.000Z',
    updatedAt: '2026-11-27T12:00:05.000Z',
    committedAt: null,
    finishedAt: null,
    ...overrides,
  });
}

describe('VM operation phases', () => {
  it('name every recorded state, and nothing that was not recorded', () => {
    const phases = REGISTRATION_STATES.map((state) => vmOperationPhase(operation({ state })));
    expect(phases).toEqual([
      'queued',
      'preparing',
      'packaging',
      'transferring',
      'verifying',
      'publishing',
      'finalizing',
      'completed',
      'failed',
      'cancelled',
      'completed_with_problem',
    ]);
  });

  it('wait for an offline agent, but never for the server', () => {
    expect(vmOperationPhase(operation({ state: 'queued', agentOnline: false }))).toBe(
      'waiting_agent',
    );
    expect(vmOperationPhase(operation({ state: 'uploading', agentOnline: false }))).toBe(
      'waiting_agent',
    );
    // An offline agent does not turn an ended operation into a waiting one.
    expect(vmOperationPhase(operation({ state: 'succeeded', agentOnline: false }))).toBe(
      'completed',
    );
    expect(
      vmOperationPhase(
        operation({ state: 'queued', performedBy: 'server', agentId: null, agentOnline: false }),
      ),
    ).toBe('queued');
  });

  it('are active exactly until a terminal state', () => {
    expect(isVmOperationActive(operation({ state: 'committing' }))).toBe(true);
    expect(isVmOperationActive(operation({ state: 'partial_success' }))).toBe(false);
  });
});

describe('VM operation progress', () => {
  it('is the recorded byte count of a measured phase', () => {
    expect(vmOperationPercent(operation())).toBe(25);
    expect(
      vmOperationPercent(
        operation({ state: 'verifying', progress: { doneBytes: 199, totalBytes: 200 } }),
      ),
    ).toBe(99);
  });

  it('is never shown at 100% while anything remains, nor for unmeasured phases', () => {
    expect(
      vmOperationPercent(operation({ progress: { doneBytes: 200, totalBytes: 200 } })),
    ).toBeNull();
    expect(vmOperationPercent(operation({ state: 'committing' }))).toBeNull();
    expect(vmOperationPercent(operation({ state: 'validating' }))).toBeNull();
    expect(
      vmOperationPercent(operation({ progress: { doneBytes: null, totalBytes: null } })),
    ).toBeNull();
    expect(vmOperationPercent(operation({ progress: { doneBytes: 0, totalBytes: 0 } }))).toBeNull();
    expect(vmOperationPercent(operation({ state: 'succeeded' }))).toBeNull();
  });
});

describe('VM operation association', () => {
  it('draws a snapshot on its parent and a clone on the version it copies', () => {
    expect(vmOperationSourceVersionId({ relation: 'this_vm', operation: operation() })).toBe(
      PARENT,
    );
    const clone = operation({
      mode: 'clone',
      vmName: 'Win98_Copy',
      parentVersionId: null,
      snapshotName: null,
      cloneSource: { vmName: 'Win98', versionId: SOURCE },
    });
    expect(vmOperationSourceVersionId({ relation: 'clone_source', operation: clone })).toBe(SOURCE);
    expect(vmOperationKind(clone)).toBe('clone');
  });

  it('draws a remaster on no version, and names a working copy’s snapshot', () => {
    const remaster = operation({ mode: 'remaster', parentVersionId: null, snapshotName: null });
    expect(vmOperationSourceVersionId({ relation: 'this_vm', operation: remaster })).toBeNull();
    expect(vmOperationKind(remaster)).toBe('remaster');
    expect(vmOperationKind(operation({ workspaceId: PARENT }))).toBe('remote_snapshot');
    expect(vmOperationKind(operation())).toBe('snapshot');
  });

  it('parses a listing, and defaults an unknown transport to null', () => {
    const parsed = vmOperationListResponseSchema.parse({
      operations: [{ relation: 'this_vm', operation: operation() }],
      retentionHours: 24,
      serverTime: '2026-11-27T12:00:06.000Z',
    });
    expect(parsed.operations[0]?.transport).toBeNull();
  });
});
